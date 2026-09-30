import * as React from "react";
import { IconProps } from "./types";

function Sheet(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M18.3334 2.5H1.66675V17.5H18.3334V2.5Z" stroke="white" strokeWidth="1.33" strokeLinejoin="round" />
      <path d="M1.09326 6.89453H13.6218V18.0479" stroke="white" strokeWidth="1.33" strokeDasharray="2 2" />
      <rect x="11.8188" y="4.68359" width="3.60559" height="3.60559" fill="white" />
    </svg>
  );
}

const MemoSheet = React.memo(Sheet);
export default MemoSheet;
