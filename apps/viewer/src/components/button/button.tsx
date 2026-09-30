import type { MouseEvent, PointerEvent } from "react";
import classNames from "classnames";
import { Loader } from "@/components/loader";
import { ButtonProps } from "./types";

// Press feedback: a quick dip (slightly smaller and dimmer) and back. A fixed
// one-shot, so a touchpad tap and a long hold look the same and it can never
// stick half-pressed. One keyframe only: the rest state on either side is the
// button's own (implicit keyframes), and `scale` rather than `transform` leaves
// any transform the button already has alone. Scale + opacity only, so it keeps
// running on the compositor while the action holds the main thread.
const PRESS_MS = 220;
const PRESS_DIP: Keyframe[] = [{ offset: 0.3, scale: "0.94", opacity: 0.55, easing: "ease-out" }];
// Reduced motion (Windows reports it whenever "Animation effects" is off): the
// dim alone has to say "pressed", which is why it is this deep.
const PRESS_DIP_STILL: Keyframe[] = [{ offset: 0.3, opacity: 0.55, easing: "ease-out" }];

function playPress(el: HTMLElement): void {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.animate(still ? PRESS_DIP_STILL : PRESS_DIP, { duration: PRESS_MS });
}

const Button = (props: ButtonProps) => {
  const {
    children,
    className,
    disabled = false,
    fullWidth = false,
    loading = false,
    variant = "primary",
    type = "button",
    pressFeedback = false,
    onPointerDown,
    onClick,
    ...rest
  } = props;

  // `loading` greys the button out without disabling it; it gets no feedback either.
  const feedback = pressFeedback && !disabled && !loading;

  // Played on press, not on click: the click is where the action runs, and a
  // synchronous one (a window.prompt) would hold the animation's first frame
  // back until it returns. A keyboard click (detail 0) has no press to play on.
  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (feedback && e.button === 0) playPress(e.currentTarget);
    onPointerDown?.(e);
  };
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (feedback && e.detail === 0) playPress(e.currentTarget);
    onClick?.(e);
  };

  const buttonClasses = classNames("flex items-center justify-center gap-2 rounded-xl px-4 py-2", className, {
    "w-full": fullWidth,
    "bg-brand-primary text-text-accent": variant === "primary",
    "bg-transparent text-text-primary": variant === "secondary",
    "bg-transparent text-text-link": variant === "link",
    "opacity-50 cursor-not-allowed": loading || disabled,
  });

  return (
    <button
      type={type}
      className={buttonClasses}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      {...rest}
    >
      {loading ? <Loader className="!w-4 !h-4 !border-2" /> : null}

      {children}
    </button>
  );
};

export default Button;
