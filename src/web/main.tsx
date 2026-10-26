import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { StartupGate } from "./components/StartupGate";
import { I18nProvider } from "./lib/i18n";
import { installPrivacyShield } from "./lib/privacy-dom";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing");
const removePrivacyShield = installPrivacyShield(document);
if (import.meta.hot) import.meta.hot.dispose(removePrivacyShield);
createRoot(el).render(
  <StrictMode>
    <I18nProvider>
      <StartupGate><App /></StartupGate>
    </I18nProvider>
  </StrictMode>
);
