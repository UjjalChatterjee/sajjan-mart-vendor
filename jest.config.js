module.exports = {
  preset: '@react-native/jest-preset',
  /* .kilo/worktrees holds a stale full copy of the repo that the editor leaves
     behind; jest matched it and ran those old suites and old sources twice. */
  testPathIgnorePatterns: ['/node_modules/', '/.kilo/'],
  /* On a cold transform cache the first test of a screen suite spends the whole
     5 s default just Babel-compiling the module graph it renders, so it fails
     with "Exceeded timeout" while every later test runs in milliseconds. This
     is the transform cost, not the code under test: measured 13 s cold, 2.2 s
     warm for the same 46 tests. */
  testTimeout: 30000,
};
