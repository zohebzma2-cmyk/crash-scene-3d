// App entry. Fonts are self-hosted (Fontsource); colors, sizes and motion come from design/tokens.css.
import "@fontsource/plus-jakarta-sans/latin-400.css";
import "@fontsource/plus-jakarta-sans/latin-500.css";
import "@fontsource/plus-jakarta-sans/latin-600.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/plus-jakarta-sans/latin-800.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "leaflet/dist/leaflet.css";
import "../../../design/tokens.css";
import "./styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createServices, fixturesRequested } from "./services";

// ?theme=dark|light forces a theme (screenshots, links).
const theme = new URLSearchParams(window.location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.classList.add(theme);

const services = createServices({ fixtures: fixturesRequested(window.location.search) });
const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><App services={services} /></StrictMode>);
