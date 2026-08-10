import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WallzAnalyzer from "./app/WallzAnalyzer";
import "./app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WallzAnalyzer />
  </StrictMode>,
);
