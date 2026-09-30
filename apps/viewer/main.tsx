import { createRoot } from "react-dom/client";

import "./src/styles/globals.css";
import AppShell from "./AppShell";

// AppShell renders the viewer alone under a plain `npm run dev`, and adds the drawing
// tool as a second tab when served by the combined dev server (see dev-server.mts).
createRoot(document.getElementById("root")!).render(<AppShell />);
