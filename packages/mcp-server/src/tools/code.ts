import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getSqlite } from '../db/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawSymbol {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd?: number;
  signature?: string;
}

interface RawRef {
  toSymbol: string;
  toFile?: string;
  kind: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function detectLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.go': 'go',
    '.py': 'python',
    '.rs': 'rust',
  };
  return map[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Symbol + import extractors (regex-based, no native deps)
// ---------------------------------------------------------------------------

function extractTypescript(lines: string[]): { symbols: RawSymbol[]; refs: RawRef[] } {
  const symbols: RawSymbol[] = [];
  const refs: RawRef[] = [];

  // Patterns for symbols
  const symPatterns: Array<{ re: RegExp; kind: string }> = [
    { re: /^export\s+(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)/, kind: 'function' },
    { re: /^export\s+(?:abstract\s+)?class\s+(\w+)/, kind: 'class' },
    { re: /^export\s+interface\s+(\w+)/, kind: 'interface' },
    { re: /^export\s+type\s+(\w+)\s*[=<]/, kind: 'type' },
    { re: /^export\s+(?:const|let|var)\s+(\w+)/, kind: 'variable' },
    { re: /^(?:async\s+)?function\s+(\w+)\s*\(/, kind: 'function' },
    { re: /^class\s+(\w+)/, kind: 'class' },
  ];

  // Import patterns
  const importNamed = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/;
  const importDefault = /^import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/;
  const importStar = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimStart();

    for (const { re, kind } of symPatterns) {
      const m = re.exec(line);
      if (m) {
        symbols.push({ name: m[1]!, kind, lineStart: i + 1, signature: line.slice(0, 120) });
        break;
      }
    }

    let m: RegExpExecArray | null;

    m = importNamed.exec(line);
    if (m) {
      const names = m[1]!.split(',').map(s => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      const src = m[2]!;
      for (const nm of names) {
        refs.push({ toSymbol: nm, toFile: src.startsWith('.') ? src : undefined, kind: 'import', line: i + 1 });
      }
      continue;
    }
    m = importStar.exec(line);
    if (m) {
      refs.push({ toSymbol: m[1]!, toFile: m[2]!, kind: 'import', line: i + 1 });
      continue;
    }
    m = importDefault.exec(line);
    if (m) {
      refs.push({ toSymbol: m[1]!, toFile: m[2]!.startsWith('.') ? m[2] : undefined, kind: 'import', line: i + 1 });
    }
  }

  return { symbols, refs };
}

function extractGo(lines: string[]): { symbols: RawSymbol[]; refs: RawRef[] } {
  const symbols: RawSymbol[] = [];
  const refs: RawRef[] = [];

  const funcRe    = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s+)?(\w+)\s*\(/;
  const typeRe    = /^type\s+(\w+)\s+(struct|interface)/;
  const constRe   = /^(?:const|var)\s+(\w+)\s/;
  const importRe  = /^"([^"]+)"/;   // applied to trimmed line, so no leading whitespace
  const importSingle = /^import\s+"([^"]+)"/;

  let inImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();

    if (trimmed === 'import (') { inImportBlock = true; continue; }
    if (inImportBlock) {
      if (trimmed === ')') { inImportBlock = false; continue; }
      const m = importRe.exec(trimmed);
      if (m) {
        const parts = m[1]!.split('/');
        refs.push({ toSymbol: parts[parts.length - 1]!, toFile: m[1], kind: 'import', line: i + 1 });
      }
      continue;
    }

    let m: RegExpExecArray | null;
    m = importSingle.exec(trimmed);
    if (m) {
      const parts = m[1]!.split('/');
      refs.push({ toSymbol: parts[parts.length - 1]!, toFile: m[1], kind: 'import', line: i + 1 });
      continue;
    }
    m = funcRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'function', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = typeRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: m[2]! === 'struct' ? 'struct' : 'interface', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = constRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'variable', lineStart: i + 1, signature: trimmed.slice(0, 80) }); }
  }

  return { symbols, refs };
}

function extractPython(lines: string[]): { symbols: RawSymbol[]; refs: RawRef[] } {
  const symbols: RawSymbol[] = [];
  const refs: RawRef[] = [];

  const defRe    = /^(?:async\s+)?def\s+(\w+)\s*\(/;
  const classRe  = /^class\s+(\w+)/;
  const fromRe   = /^from\s+([\w.]+)\s+import\s+(.+)/;
  const importRe = /^import\s+(.+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    let m: RegExpExecArray | null;

    m = defRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'function', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = classRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'class', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = fromRe.exec(trimmed);
    if (m) {
      const names = m[2]!.split(',').map(s => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      for (const nm of names) {
        if (nm !== '*') refs.push({ toSymbol: nm, toFile: m[1], kind: 'import', line: i + 1 });
      }
      continue;
    }
    m = importRe.exec(trimmed);
    if (m) {
      const names = m[1]!.split(',').map(s => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
      for (const nm of names) refs.push({ toSymbol: nm, kind: 'import', line: i + 1 });
    }
  }

  return { symbols, refs };
}

function extractRust(lines: string[]): { symbols: RawSymbol[]; refs: RawRef[] } {
  const symbols: RawSymbol[] = [];
  const refs: RawRef[] = [];

  const fnRe     = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*[<(]/;
  const structRe = /^(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(\w+)/;
  const enumRe   = /^(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+(\w+)/;
  const traitRe  = /^(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+(\w+)/;
  const implRe   = /^impl(?:<[^>]+>)?\s+(?:(\w+)\s+for\s+)?(\w+)/;
  const useRe    = /^use\s+([\w:{}*, ]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    let m: RegExpExecArray | null;

    m = fnRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'function', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = structRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'struct', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = enumRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'enum', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = traitRe.exec(trimmed);
    if (m) { symbols.push({ name: m[1]!, kind: 'trait', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = implRe.exec(trimmed);
    if (m) { symbols.push({ name: m[2]!, kind: 'impl', lineStart: i + 1, signature: trimmed.slice(0, 120) }); continue; }
    m = useRe.exec(trimmed);
    if (m) {
      const raw = m[1]!.replace(/[{}]/g, ' ').split(/[,\s]+/).map(s => s.trim()).filter(s => /^\w+$/.test(s));
      for (const nm of raw) refs.push({ toSymbol: nm, kind: 'import', line: i + 1 });
    }
  }

  return { symbols, refs };
}

function extractSymbols(filePath: string, lang: string, lines: string[]): { symbols: RawSymbol[]; refs: RawRef[] } {
  switch (lang) {
    case 'typescript':
    case 'javascript': return extractTypescript(lines);
    case 'go':         return extractGo(lines);
    case 'python':     return extractPython(lines);
    case 'rust':       return extractRust(lines);
    default:           return { symbols: [], refs: [] };
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function upsertFileIndex(sqlite: ReturnType<typeof getSqlite>, filePath: string, projectId: string | null, lang: string | null, symbols: RawSymbol[], refs: RawRef[]): { symbolsWritten: number; refsWritten: number } {
  const now = new Date().toISOString();
  const fileDir = path.dirname(filePath);

  // Use IS for NULL-safe project scoping — (? IS NULL OR ...) would wipe all projects when null
  sqlite.prepare(`DELETE FROM code_refs    WHERE from_file = ? AND project_id IS ?`).run(filePath, projectId);
  sqlite.prepare(`DELETE FROM code_symbols WHERE file_path = ? AND project_id IS ?`).run(filePath, projectId);

  const insertSym = sqlite.prepare(`
    INSERT INTO code_symbols (project_id, file_path, name, kind, language, line_start, line_end, signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRef = sqlite.prepare(`
    INSERT INTO code_refs (project_id, from_file, to_symbol, to_file, kind, line, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const write = sqlite.transaction(() => {
    for (const s of symbols) {
      insertSym.run(projectId, filePath, s.name, s.kind, lang, s.lineStart, s.lineEnd ?? null, s.signature ?? null, now, now);
    }
    for (const r of refs) {
      // Resolve relative imports to absolute paths so get_graph reverse lookup works
      const absToFile = r.toFile
        ? (r.toFile.startsWith('.') ? path.resolve(fileDir, r.toFile) : r.toFile)
        : null;
      insertRef.run(projectId, filePath, r.toSymbol, absToFile, r.kind, r.line, now);
    }
  });
  write();

  return { symbolsWritten: symbols.length, refsWritten: refs.length };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerCodeTools(server: McpServer): void {

  // ---- code.map_file -------------------------------------------------------
  server.registerTool('code.map_file', {
    description: 'Parse a source file and index all its symbols and imports into the codebase graph. Re-indexes if already present.',
    inputSchema: {
      filePath:  z.string().min(1).describe('Absolute path to the file'),
      projectId: z.string().optional(),
    },
  }, async ({ filePath, projectId }) => {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const lang = detectLanguage(filePath);
    if (!lang) return { content: [{ type: 'text' as const, text: JSON.stringify({ skipped: true, reason: 'unsupported extension', file: filePath }) }] };

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    const { symbols, refs } = extractSymbols(filePath, lang, lines);

    const sqlite = getSqlite();
    const counts = upsertFileIndex(sqlite, filePath, projectId ?? null, lang, symbols, refs);

    return { content: [{ type: 'text' as const, text: JSON.stringify({ file: filePath, language: lang, ...counts }) }] };
  });

  // ---- code.map_project ----------------------------------------------------
  server.registerTool('code.map_project', {
    description: 'Walk all source files in a directory and index their symbols. Skips node_modules, .git, dist, build. Returns totals.',
    inputSchema: {
      dir:        z.string().min(1).describe('Root directory to walk'),
      projectId:  z.string().optional(),
      extensions: z.array(z.string()).optional().describe('Extensions to include, e.g. [".ts",".go"]. Default: all supported.'),
      maxFiles:   z.number().int().positive().optional().describe('Safety cap — default 2000'),
    },
  }, async ({ dir, projectId, extensions, maxFiles = 2000 }) => {
    const supported = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.py', '.rs']);
    const allowed = extensions ? new Set(extensions) : supported;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', '__pycache__', 'target']);

    const queue: string[] = [dir];
    const filesToProcess: string[] = [];

    while (queue.length > 0 && filesToProcess.length < maxFiles) {
      const cur = queue.shift()!;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (skip.has(e.name)) continue;
        const full = path.join(cur, e.name);
        if (e.isDirectory()) { queue.push(full); }
        else if (e.isFile() && allowed.has(path.extname(e.name).toLowerCase())) {
          if (filesToProcess.length < maxFiles) filesToProcess.push(full);
        }
      }
    }

    const sqlite = getSqlite();
    let totalSymbols = 0;
    let totalRefs = 0;
    let skipped = 0;

    for (const fp of filesToProcess) {
      const lang = detectLanguage(fp);
      if (!lang) { skipped++; continue; }
      try {
        const content = fs.readFileSync(fp, 'utf8');
        const lines = content.split('\n');
        const { symbols, refs } = extractSymbols(fp, lang, lines);
        const counts = upsertFileIndex(sqlite, fp, projectId ?? null, lang, symbols, refs);
        totalSymbols += counts.symbolsWritten;
        totalRefs += counts.refsWritten;
      } catch { skipped++; }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify({ dir, files: filesToProcess.length - skipped, skipped, symbols: totalSymbols, refs: totalRefs }) }] };
  });

  // ---- code.lookup_symbol --------------------------------------------------
  server.registerTool('code.lookup_symbol', {
    description: 'Find where a symbol is defined. Returns file, line, kind, and signature for each match.',
    inputSchema: {
      name:      z.string().min(1),
      projectId: z.string().optional(),
      kind:      z.string().optional().describe('Filter by kind: function, class, interface, type, variable, struct, enum, trait'),
      limit:     z.number().int().positive().optional().default(20),
    },
  }, async ({ name, projectId, kind, limit = 20 }) => {
    const sqlite = getSqlite();
    let sql = `SELECT file_path, line_start, line_end, kind, language, signature FROM code_symbols WHERE name = ? AND (? IS NULL OR project_id = ?)`;
    const params: unknown[] = [name, projectId ?? null, projectId ?? null];
    if (kind) { sql += ` AND kind = ?`; params.push(kind); }
    sql += ` LIMIT ?`;
    params.push(limit);
    const rows = sqlite.prepare(sql).all(...params) as Array<{ file_path: string; line_start: number; line_end: number | null; kind: string; language: string | null; signature: string | null }>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map(r => ({ file: r.file_path, line: r.line_start, kind: r.kind, language: r.language, signature: r.signature }))) }] };
  });

  // ---- code.find_refs ------------------------------------------------------
  server.registerTool('code.find_refs', {
    description: 'Find all files that import or reference a symbol. Returns file, line, and reference kind.',
    inputSchema: {
      symbolName: z.string().min(1),
      projectId:  z.string().optional(),
      limit:      z.number().int().positive().optional().default(50),
    },
  }, async ({ symbolName, projectId, limit = 50 }) => {
    const sqlite = getSqlite();
    const rows = sqlite.prepare(`
      SELECT from_file, line, kind, to_file FROM code_refs
      WHERE to_symbol = ? AND (? IS NULL OR project_id = ?)
      ORDER BY from_file LIMIT ?
    `).all(symbolName, projectId ?? null, projectId ?? null, limit) as Array<{ from_file: string; line: number | null; kind: string; to_file: string | null }>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map(r => ({ file: r.from_file, line: r.line, kind: r.kind, resolvedFrom: r.to_file }))) }] };
  });

  // ---- code.get_file_outline -----------------------------------------------
  server.registerTool('code.get_file_outline', {
    description: 'List all indexed symbols defined in a file. Much cheaper than reading the file — use this before deciding to read.',
    inputSchema: {
      filePath:  z.string().min(1),
      projectId: z.string().optional(),
    },
  }, async ({ filePath, projectId }) => {
    const sqlite = getSqlite();
    const rows = sqlite.prepare(`
      SELECT name, kind, line_start, line_end, signature
      FROM code_symbols WHERE file_path = ? AND (? IS NULL OR project_id = ?)
      ORDER BY line_start
    `).all(filePath, projectId ?? null, projectId ?? null) as Array<{ name: string; kind: string; line_start: number; line_end: number | null; signature: string | null }>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map(r => ({ name: r.name, kind: r.kind, line: r.line_start, endLine: r.line_end, signature: r.signature }))) }] };
  });

  // ---- code.search_symbols -------------------------------------------------
  server.registerTool('code.search_symbols', {
    description: 'Full-text search across all indexed symbol names and signatures. Returns ranked matches.',
    inputSchema: {
      query:     z.string().min(1),
      projectId: z.string().optional(),
      limit:     z.number().int().positive().optional().default(20),
    },
  }, async ({ query, projectId, limit = 20 }) => {
    const sqlite = getSqlite();
    const rows = sqlite.prepare(`
      SELECT s.file_path, s.name, s.kind, s.line_start, s.signature, s.language
      FROM code_symbols_fts f
      JOIN code_symbols s ON s.id = f.rowid
      WHERE code_symbols_fts MATCH ? AND (? IS NULL OR s.project_id = ?)
      ORDER BY rank
      LIMIT ?
    `).all(query, projectId ?? null, projectId ?? null, limit) as Array<{ file_path: string; name: string; kind: string; line_start: number; signature: string | null; language: string | null }>;
    return { content: [{ type: 'text' as const, text: JSON.stringify(rows.map(r => ({ file: r.file_path, name: r.name, kind: r.kind, line: r.line_start, signature: r.signature, language: r.language }))) }] };
  });

  // ---- code.get_graph ------------------------------------------------------
  server.registerTool('code.get_graph', {
    description: 'Return the import adjacency for a file: what it imports and which files import it.',
    inputSchema: {
      filePath:  z.string().min(1),
      projectId: z.string().optional(),
    },
  }, async ({ filePath, projectId }) => {
    const sqlite = getSqlite();

    const imports = sqlite.prepare(`
      SELECT DISTINCT to_symbol, to_file FROM code_refs
      WHERE from_file = ? AND kind = 'import' AND (? IS NULL OR project_id = ?)
    `).all(filePath, projectId ?? null, projectId ?? null) as Array<{ to_symbol: string; to_file: string | null }>;

    // to_file stores absolute paths; imports may omit the extension (e.g. './db/index' → '/abs/db/index')
    // so match both the exact path and the path without its extension
    const filePathNoExt = filePath.replace(/\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs)$/, '');
    const importedBy = sqlite.prepare(`
      SELECT DISTINCT from_file FROM code_refs
      WHERE (to_file = ? OR to_file = ?) AND kind = 'import' AND (? IS NULL OR project_id = ?)
    `).all(filePath, filePathNoExt, projectId ?? null, projectId ?? null) as Array<{ from_file: string }>;

    return { content: [{ type: 'text' as const, text: JSON.stringify({
      file: filePath,
      imports: imports.map(r => ({ symbol: r.to_symbol, resolvedFile: r.to_file })),
      importedBy: importedBy.map(r => r.from_file),
    }) }] };
  });

  // ---- code.delete_file_index ----------------------------------------------
  server.registerTool('code.delete_file_index', {
    description: 'Remove all indexed symbols and references for a file. Call this after deleting or renaming a file.',
    inputSchema: {
      filePath:  z.string().min(1),
      projectId: z.string().optional(),
    },
  }, async ({ filePath, projectId }) => {
    const sqlite = getSqlite();
    const syms = sqlite.prepare(`DELETE FROM code_symbols WHERE file_path = ? AND project_id IS ?`).run(filePath, projectId ?? null);
    const refs = sqlite.prepare(`DELETE FROM code_refs WHERE from_file = ? AND project_id IS ?`).run(filePath, projectId ?? null);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ deleted: { symbols: syms.changes, refs: refs.changes } }) }] };
  });
}
