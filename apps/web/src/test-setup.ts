/**
 * Vitest setup file. Imported via `setupFiles` in vitest.config.ts.
 *
 * Currently only adds `@testing-library/jest-dom` matchers (e.g.
 * `toBeInTheDocument`) so component tests can use the same expressive
 * assertions as the rest of the React ecosystem.
 *
 * Auto-cleanup is intentionally NOT enabled here: each test file calls
 * `afterEach(cleanup)` itself. That keeps jsdom startup cost out of
 * pure-logic suites that never use React.
 */
import '@testing-library/jest-dom/vitest';
