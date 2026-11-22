/** @type {import('jest').Config} */
const common = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Shared contracts are consumed from source in tests (no build step required).
  moduleNameMapper: { '^@frontdesk/contracts$': '<rootDir>/packages/contracts/src/index.ts' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tests/tsconfig.json', diagnostics: true }],
  },
};
module.exports = {
  testTimeout: 120000,
  projects: [
    {
      ...common,
      displayName: 'unit',
      rootDir: '.',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      rootDir: '.',
      testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/tests/integration/global-setup.ts',
      globalTeardown: '<rootDir>/tests/integration/global-teardown.ts',
    },
  ],
};
