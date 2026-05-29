import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/ibm-plex-mono/400.css";

import React from "react";
import ReactDOM from "react-dom/client";
import "svara-ui/styles.css";
import "svara-ui/labelau/styles.css";

import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
