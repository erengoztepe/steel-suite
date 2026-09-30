import * as React from "react";
import { IconProps } from "./types";

function Search(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M17.5 17.5l-2.917-2.917m2.084-5a7.083 7.083 0 11-14.167 0 7.083 7.083 0 0114.167 0z"
        strokeWidth={1.667}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoSearch = React.memo(Search);
export default MemoSearch;
