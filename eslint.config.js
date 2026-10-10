import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const noHtmlInjection = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Never render HTML. Scene data is shown as text only." },
  { selector: "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]", message: "Never assign HTML. Use textContent or DOM APIs." },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: "Never insert HTML." },
  { selector: "CallExpression[callee.object.name='document'][callee.property.name='write']", message: "Never document.write." },
];

export default tseslint.config(
  { ignores: [".claude/**", "**/node_modules/**", "**/dist/**", "design/**", "playwright-report/**", "test-results/**", "examples/**", ".netlify/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...noHtmlInjection],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    // The core, map data and export logic must run server-side later: no DOM, no three.
    files: ["packages/core/src/**/*.ts", "packages/mapdata/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["three", "three/*", "@react-three/*", "react", "react-dom", "leaflet"] }],
      "no-restricted-globals": ["error", "window", "document", "localStorage", "sessionStorage", "navigator"],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Scene code reads colors from tokens only. three.js cameras/controls are
    // mutable objects by design, so the hooks immutability rule doesn't apply here.
    files: ["apps/web/src/viewer/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/immutability": "off",
      "no-restricted-syntax": ["error", ...noHtmlInjection,
        { selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]", message: "No color literals in scene code: read tokens via the token reader." },
        { selector: "Literal[value=/^(rgb|rgba|hsl|hsla)\\(/]", message: "No color literals in scene code: read tokens via the token reader." },
        { selector: "NewExpression[callee.property.name='Color'][arguments.0.type='Literal']", message: "No color literals in scene code." }],
    },
  },
);
