import * as React from "react";
import { IconProps } from "./types";

function Orbit(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <g clipPath="url(#clip0_170_29473)">
        <mask id="mask0_170_29473" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <path d="M0 1.90735e-06H16V16H0V1.90735e-06Z" fill="white" />
        </mask>
        <g mask="url(#mask0_170_29473)">
          <path d="M10.0953 12.4111C9.5932 14.1705 8.81978 15.2002 8.00023 15.2002C6.53633 15.2002 5.34961 11.9766 5.34961 8.00017C5.34961 4.02372 6.53633 0.800145 8.00023 0.800145C8.81754 0.800145 9.5892 1.82437 10.0914 3.57592" stroke="white" strokeWidth="1.5" strokeMiterlimit="22.926" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.23559 9.98712C1.6869 9.48396 0.799805 8.76019 0.799805 7.99977C0.799805 6.53586 4.02335 5.34914 7.99983 5.34914C11.9763 5.34914 15.1999 6.53586 15.1999 7.99977C15.1999 9.46367 11.9763 10.6504 7.99983 10.6504C7.89766 10.6504 7.79548 10.6496 7.69343 10.648" stroke="white" strokeWidth="1.5" strokeMiterlimit="22.926" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M1.96875 10.875L3.70261 10.1172L2.81065 8.44557" stroke="white" strokeWidth="1.5" strokeMiterlimit="22.926" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8.44629 2.64673L10.0923 3.58008L10.8954 1.86399" stroke="white" strokeWidth="1.5" strokeMiterlimit="22.926" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </g>
      <defs>
        <clipPath id="clip0_170_29473">
          <rect width="16" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

const MemoOrbit = React.memo(Orbit);
export default MemoOrbit;
