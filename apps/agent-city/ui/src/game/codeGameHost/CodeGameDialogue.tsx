import { useEffect } from "react";
import type { CodeGameDialogueStateV1 } from "./useCodeGamePreview";
import "../game.css";

export function CodeGameDialogue(props: Readonly<{
  dialogue: CodeGameDialogueStateV1;
  language: "en" | "zh-Hans";
  onChoice: (choiceId: string) => void;
  onClose: () => void;
}>) {
  const { dialogue, language, onChoice, onClose } = props;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);
  return <div className="code-game-dialogue-backdrop">
    <section className="code-game-dialogue" role="dialog" aria-modal="true" aria-labelledby="code-game-dialogue-speaker">
      <button type="button" className="code-game-dialogue-close" aria-label={language === "en" ? "Close dialogue" : "关闭对话"} onClick={onClose}>×</button>
      <div className="code-game-dialogue-avatar" aria-hidden="true">{dialogue.speaker.displayName.trim().charAt(0).toUpperCase()}</div>
      <div className="code-game-dialogue-content">
        <p className="code-game-dialogue-speaker" id="code-game-dialogue-speaker">{dialogue.speaker.displayName}</p>
        <p className="code-game-dialogue-text">{dialogue.text}</p>
        <div className="code-game-dialogue-choices">
          {dialogue.choices.map((choice) => <button type="button" key={choice.id} data-dialogue-choice={choice.id}
            disabled={choice.enabled === false} autoFocus={choice.enabled !== false && dialogue.choices[0] === choice}
            onClick={() => onChoice(choice.id)}>{choice.label}</button>)}
        </div>
      </div>
    </section>
  </div>;
}
