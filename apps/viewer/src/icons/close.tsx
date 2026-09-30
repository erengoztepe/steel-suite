import * as React from "react";

import { IconProps } from "./types";

function Close({ stroke = "#A1B0E7", ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      stroke={stroke}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M12.6673 3.33337L3.33398 12.6667M3.33398 3.33337L12.6673 12.6667"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoClose = React.memo(Close);
export default MemoClose;
