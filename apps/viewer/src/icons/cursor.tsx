import * as React from "react";
import { IconProps } from "./types";

function Cursor(props: IconProps) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" {...props} >
      <path d="M13 5L1 1L5 13L7 7L13 5Z" stroke="white" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

const MemoCursor = React.memo(Cursor);
export default MemoCursor;
