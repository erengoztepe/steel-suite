import * as React from "react";
import { IconProps } from "./types";

function PerspectiveView(props: IconProps) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" {...props}>
      <g clipPath="url(#clip0_171_32423)">
        <path
          d="M2.52542 4.05085C3.36789 4.05085 4.05085 3.36789 4.05085 2.52542C4.05085 1.68296 3.36789 1 2.52542 1C1.68296 1 1 1.68296 1 2.52542C1 3.36789 1.68296 4.05085 2.52542 4.05085Z"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.4746 7.10163C18.3171 7.10163 19.0001 6.41867 19.0001 5.57621C19.0001 4.73374 18.3171 4.05078 17.4746 4.05078C16.6322 4.05078 15.9492 4.73374 15.9492 5.57621C15.9492 6.41867 16.6322 7.10163 17.4746 7.10163Z"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.4746 15.9493C18.3171 15.9493 19.0001 15.2663 19.0001 14.4239C19.0001 13.5814 18.3171 12.8984 17.4746 12.8984C16.6322 12.8984 15.9492 13.5814 15.9492 14.4239C15.9492 15.2663 16.6322 15.9493 17.4746 15.9493Z"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2.52542 19.0001C3.36789 19.0001 4.05085 18.3171 4.05085 17.4746C4.05085 16.6322 3.36789 15.9492 2.52542 15.9492C1.68296 15.9492 1 16.6322 1 17.4746C1 18.3171 1.68296 19.0001 2.52542 19.0001Z"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7.48291 3.5166V16.4827"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M12.6694 4.58496V15.4155"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2.52539 10.3818H17.4745"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M15.9784 14.7227L4.02148 17.1751"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2.52539 15.9491V4.05078"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.02148 2.8252L15.9784 5.27762"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M17.4746 7.10156V12.8982"
          stroke="white"
          strokeWidth="1.5"
          strokeMiterlimit="10"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
      <defs>
        <clipPath id="clip0_171_32423">
          <rect width="20" height="20" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

const MemoPerspectiveView = React.memo(PerspectiveView);
export default MemoPerspectiveView;
