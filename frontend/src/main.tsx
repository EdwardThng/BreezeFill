import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// styles.css is the claim UI's (light, form-shaped); the other two are the
// marketing site's and are scoped under .landing / .demo so they cannot meet.
import "./styles.css";
import "./landing.css";
import "./demo.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
