/** Shared keyboard button source. Mapping and interruption policy belong to the
 * vehicle/session; window focus, IME, modifiers, held keys and listener lifetime do not. */
export type InputInterrupt = "focus-lost" | "host-hidden" | "host-suspended";
export type KeyboardInputOptions<Input extends object> = Readonly<{
  keys: Readonly<Record<string, keyof Input>>;
  emptyInput(): Input;
  isFocused(): boolean;
  onInterrupt(reason: InputInterrupt): void;
  onInput?(input: Readonly<Input>): void;
  onCommand?(event: KeyboardEvent): boolean;
  /** Canvas to blur if the browser focuses it. Game input is captured at window level. */
  blurFocusTarget?(): HTMLElement | null;
  capture?: boolean;
}>;
export class KeyboardInput<Input extends object> {
  private state: Input;
  private readonly held = new Set<string>();
  private attached = false;
  constructor(private readonly options: KeyboardInputOptions<Input>) { this.state = options.emptyInput(); }
  snapshot(): Input { return { ...this.state }; }
  clear(): void { this.held.clear(); this.state = this.options.emptyInput(); this.options.onInput?.(this.snapshot()); }
  attach(): void {
    if (this.attached) return; this.attached = true;
    window.addEventListener("keydown", this.down, this.options.capture ?? false);
    window.addEventListener("keydown", this.blockInputSourceSwitch, true);
    window.addEventListener("keyup", this.up, this.options.capture ?? false);
    window.addEventListener("blur", this.blur);
    window.addEventListener("__AV_PLUGIN_SUSPENDED__", this.suspend);
    document.addEventListener("visibilitychange", this.visibility);
    document.addEventListener("focusin", this.focusIn, true);
    document.addEventListener("compositionstart", this.composition, true);
    document.addEventListener("compositionupdate", this.composition, true);
    document.addEventListener("compositionend", this.composition, true);
    document.addEventListener("beforeinput", this.beforeInput, true);
    const canvas = this.options.blurFocusTarget?.();
    if (canvas && document.activeElement === canvas) canvas.blur();
  }
  detach(): void {
    if (!this.attached) return; this.attached = false; this.clear();
    window.removeEventListener("keydown", this.down, this.options.capture ?? false);
    window.removeEventListener("keydown", this.blockInputSourceSwitch, true);
    window.removeEventListener("keyup", this.up, this.options.capture ?? false);
    window.removeEventListener("blur", this.blur);
    window.removeEventListener("__AV_PLUGIN_SUSPENDED__", this.suspend);
    document.removeEventListener("visibilitychange", this.visibility);
    document.removeEventListener("focusin", this.focusIn, true);
    document.removeEventListener("compositionstart", this.composition, true);
    document.removeEventListener("compositionupdate", this.composition, true);
    document.removeEventListener("compositionend", this.composition, true);
    document.removeEventListener("beforeinput", this.beforeInput, true);
  }
  private readonly focusIn = (event: FocusEvent) => {
    // Never move focus into the game canvas: macOS/WebKit can create a native
    // text-input client for a focused canvas and start the active IME there.
    const target = event.target;
    if (target === this.options.blurFocusTarget?.()) {
      (target as HTMLElement).blur();
      this.clear();
      return;
    }
    // Keep genuine text fields usable, but never carry a held vehicle key into
    // them. No refocus is attempted; the next game key is handled at window.
    this.clear();
  };
  private readonly composition = (event: CompositionEvent) => {
    if (!this.canCapture() || this.isFocusedTextEntry()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  private readonly beforeInput = (event: InputEvent) => {
    if (!this.canCapture() || this.isFocusedTextEntry() || !event.inputType.startsWith("insert")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  /** macOS commonly uses Control+Space to switch input sources. Consume it
   * before it can open a text composition path while the game owns focus. */
  private readonly blockInputSourceSwitch = (event: KeyboardEvent) => {
    if (!this.canCapture() || this.isFocusedTextEntry() || event.code !== "Space" || !event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.clear();
  };
  private isTextEntryTarget(target: HTMLElement): boolean {
    if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
    if (target.tagName !== "INPUT") return false;
    const type = (target as HTMLInputElement).type?.toLowerCase() ?? "text";
    return !["range", "checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(type);
  }
  private isFocusedTextEntry(): boolean {
    const target = document.activeElement;
    return target instanceof HTMLElement && this.isTextEntryTarget(target);
  }
  private canCapture(): boolean {
    return this.options.isFocused() && document.visibilityState !== "hidden";
  }
  private readonly down = (event: KeyboardEvent) => {
    const target = event.target;
    const textEntryTarget = target instanceof HTMLElement && this.isTextEntryTarget(target);
    const gameFocused = this.canCapture();
    // Let a real focused field receive text. A transient WebKit IME target that
    // is not the active DOM element is treated as a game event and suppressed.
    if (textEntryTarget && document.activeElement === target) return;
    if (!gameFocused) return;
    if (event.isComposing || event.keyCode === 229) {
      if (!gameFocused) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const key = this.options.keys[event.code];
      // During IME composition, character-level key values are unreliable, but
      // a mapped physical code (for example KeyW) still gives games a usable
      // control. Unknown/IME-only keys are never allowed to leave a held input.
      if (key === undefined || event.metaKey || event.ctrlKey || event.altKey) { this.clear(); return; }
      if (event.repeat) return;
      this.held.add(event.code);
      this.state[key] = true as Input[keyof Input];
      this.options.onInput?.(this.snapshot());
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (this.options.onCommand?.(event)) return;
    const key = this.options.keys[event.code];
    if (key === undefined || event.repeat) {
      // Prevent printable keys from entering a WebKit text client while the
      // game owns keyboard input, even when the key has no gameplay binding.
      if (!event.repeat && event.key?.length === 1) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    this.held.add(event.code);
    this.state[key] = true as Input[keyof Input];
    this.options.onInput?.(this.snapshot());
  };
  private readonly up = (event: KeyboardEvent) => {
    const key = this.options.keys[event.code];
    if (key === undefined) return;
    this.held.delete(event.code);
    this.state[key] = [...this.held].some((code) => this.options.keys[code] === key) as Input[keyof Input];
    this.options.onInput?.(this.snapshot());
  };
  private readonly blur = () => { this.clear(); this.options.onInterrupt("focus-lost"); };
  private readonly suspend = () => { this.clear(); this.options.onInterrupt("host-suspended"); };
  private readonly visibility = () => { if (document.visibilityState === "hidden") { this.clear(); this.options.onInterrupt("host-hidden"); } };
}
