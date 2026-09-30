import * as React from "react";
import { IconProps } from "./types";

function Graph(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" {...props}>
      <circle cx="10" cy="4" r="2" stroke="#C2CBDE" strokeWidth={1.5} />
      <circle cx="4" cy="14" r="2" stroke="#C2CBDE" strokeWidth={1.5} />
      <circle cx="16" cy="14" r="2" stroke="#C2CBDE" strokeWidth={1.5} />
      <path d="M8.5 5.5L5.5 12.5" stroke="#C2CBDE" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M11.5 5.5L14.5 12.5" stroke="#C2CBDE" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M6 14H14" stroke="#C2CBDE" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

const MemoGraph = React.memo(Graph);
export default MemoGraph;
