import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  workerOn:    boolean;
  budgetUsed:  number;
  budgetLimit: number;
  projectId:   string | null;
}

export function StatusBar({ workerOn, budgetUsed, budgetLimit }: StatusBarProps) {
  const budgetStr = budgetLimit > 0
    ? `${(budgetUsed / 1000).toFixed(0)}k / ${(budgetLimit / 1000).toFixed(0)}k tokens`
    : budgetUsed > 0
      ? `${(budgetUsed / 1000).toFixed(0)}k tokens used`
      : '';

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color={workerOn ? 'cyan' : 'gray'}>
        {workerOn ? '▶ worker' : '■ worker'}
      </Text>
      {budgetStr && (
        <>
          <Text color="gray">  ·  </Text>
          <Text color="gray">{budgetStr}</Text>
        </>
      )}
      <Box flexGrow={1} />
      <Text color="gray">↑↓ history  /help  ^C quit</Text>
    </Box>
  );
}
