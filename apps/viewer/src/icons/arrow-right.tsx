import * as React from "react";
import { IconProps } from "./types";

function ArrowRight(props: IconProps) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M9.00005 6L15 12L9 18" stroke="white" strokeWidth="1.5" strokeMiterlimit="16" />
    </svg>
  );
}

const MemoArrowRight = React.memo(ArrowRight);
export default MemoArrowRight;
