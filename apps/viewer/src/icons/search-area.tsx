import * as React from "react";
import { IconProps } from "./types";

function SearchArea(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M16.1667 16.1667L18.3333 18.3333M17.25 12.375C17.25 9.68261 15.0674 7.5 12.375 7.5C9.68261 7.5 7.5 9.68261 7.5 12.375C7.5 15.0674 9.68261 17.25 12.375 17.25C15.0674 17.25 17.25 15.0674 17.25 12.375Z"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1.66699 4.99984C1.77574 3.88692 2.02216 3.13842 2.58053 2.58005C3.13891 2.02167 3.88741 1.77525 5.00033 1.6665M5.00033 18.3332C3.88741 18.2244 3.13891 17.978 2.58053 17.4196C2.02216 16.8613 1.77574 16.1128 1.66699 14.9998M18.3337 4.99984C18.2249 3.88692 17.9785 3.13842 17.4201 2.58005C16.8617 2.02167 16.1132 1.77525 15.0003 1.6665M1.66699 8.33317L1.66699 11.6665M11.667 1.6665L8.33366 1.6665"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const MemoSearchArea = React.memo(SearchArea);
export default MemoSearchArea;
