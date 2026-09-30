import * as React from "react";
import { IconProps } from "./types";

function Integration({ color = "currentColor", ...props }: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M8 6V4.5C8 3.67 8.67 3 9.5 3S11 3.67 11 4.5V6"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 8H4.5C3.67 8 3 8.67 3 9.5S3.67 11 4.5 11H6"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 6H11V11H6V6Z"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 13H18V18H13V13Z"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16 13V11.5C16 10.67 16.67 10 17.5 10S19 10.67 19 11.5V13"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 16H19.5C20.33 16 21 16.67 21 17.5S20.33 19 19.5 19H18"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M11 11L13 13"
        stroke="#AFD8D4"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoIntegration = React.memo(Integration);
export default MemoIntegration;
