import * as React from "react";
import { IconProps } from "./types";

function ArrowLeft(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M4 12h16M9 17s-5-3.682-5-5 5-5 5-5"
        stroke="#fff"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoArrowLeft = React.memo(ArrowLeft);
export default MemoArrowLeft;
