import { createRoot } from "react-dom/client";
import { CreatorStudioApp } from "./app/CreatorStudioApp";
import "./style.css";
import "./app/studioWorkspace.css";

createRoot(document.getElementById("root")!).render(<CreatorStudioApp />);
