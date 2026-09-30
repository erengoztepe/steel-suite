import * as React from "react";
import { IconProps } from "./types";

function EyeShow(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 21" fill="none" {...props}>
      <path d="M9.999 12.957a2.27 2.27 0 100-4.54 2.27 2.27 0 000 4.54z" fill="#626C77" />
      <path
        d="M18.141 10.063C16.189 7.172 13.094 5.479 9.999 5.5c-3.094-.021-6.19 1.672-8.141 4.563a1.114 1.114 0 000 1.25c1.952 2.89 5.047 4.583 8.141 4.562 3.095.02 6.19-1.672 8.142-4.563a1.114 1.114 0 000-1.25zm-8.142 4.132a3.508 3.508 0 110-7.016 3.508 3.508 0 010 7.016z"
        fill="#626C77"
      />
    </svg>
  );
}

const MemoEyeShow = React.memo(EyeShow);
export default MemoEyeShow;
