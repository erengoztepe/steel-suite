import * as React from "react";
import { IconProps } from "./types";

function ChevronRight(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.52925 3.52851C5.7896 3.26816 6.21171 3.26816 6.47206 3.52851L10.4721 7.52851C10.7324 7.78886 10.7324 8.21097 10.4721 8.47132L6.47206 12.4713C6.21171 12.7317 5.7896 12.7317 5.52925 12.4713C5.2689 12.211 5.2689 11.7889 5.52925 11.5285L9.05784 7.99992L5.52925 4.47132C5.2689 4.21097 5.2689 3.78886 5.52925 3.52851Z"
        fill="white"
      />
    </svg>
  );
}

const MemoChevronRight = React.memo(ChevronRight);
export default MemoChevronRight;
