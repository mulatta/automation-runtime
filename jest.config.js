module.exports = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  testMatch: ["**/test/**/*.test.ts"],
  modulePathIgnorePatterns: ["<rootDir>/dist/"],
};
