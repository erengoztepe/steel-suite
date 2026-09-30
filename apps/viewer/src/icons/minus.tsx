import * as React from "react";
import { IconProps } from "./types";

function Minus({ stroke = "white", ...props }: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      stroke={stroke}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M20 12L4 12" stroke="#141B34" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MinusPlus = React.memo(Minus);
export default MinusPlus;
