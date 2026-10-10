export default {
  plugins: ["stylelint-declaration-strict-value"],
  rules: {
    "color-no-hex": true,
    "function-disallowed-list": ["rgb", "rgba", "hsl", "hsla", "oklch"],
    "scale-unlimited/declaration-strict-value": [
      ["/color$/", "fill", "stroke", "z-index", "font-size", "font-family", "border-radius", "box-shadow", "/^gap$/", "/^(margin|padding)/"],
      { ignoreValues: ["inherit", "currentColor", "transparent", "none", "0", "auto", "initial", "unset"], disableFix: true },
    ],
  },
};
