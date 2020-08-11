module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "prettier/@typescript-eslint",
  ],
  rules: {
    "prefer-const": ["warn"],
    "no-constant-condition": ["warn"],
    "@typescript-eslint/no-empty-function": ["warn"],
    "@typescript-eslint/no-explicit-any": ["warn"],
  },
};
