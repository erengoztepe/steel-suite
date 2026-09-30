export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  fullWidth?: boolean;
  loading?: boolean;
  variant?: "primary" | "secondary" | "link";
  /** Play a short dip on press, for buttons whose action shows nothing on screen (downloads, copy). */
  pressFeedback?: boolean;
};
