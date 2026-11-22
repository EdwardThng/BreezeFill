import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// styles.css is the claim UI's (light, form-shaped); home.css is the homepage,
// scoped under .home; landing.css and demo.css serve #/get and #/demo, scoped
// under .landing / .demo, so none of the three can meet.
import "./styles.css";
import "./landing.css";
import "./home.css";
import "./demo.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
