import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect } from 'vitest';

// Registered explicitly (the package's /vitest entry resolves 'vitest' from the hoisted root, which npm does not provide here).
expect.extend(matchers);
afterEach(() => cleanup());
