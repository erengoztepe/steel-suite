import * as React from "react";

import { IconProps } from "./types";

function Share(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M7.61981 8.90915L7.79225 8.73671C9.4412 7.08776 12.1147 7.08776 13.7636 8.73671C15.4126 10.3857 15.4126 13.0591 13.7636 14.7081L11.3751 17.0966C9.72612 18.7456 7.05265 18.7456 5.4037 17.0966C3.75476 15.4477 3.75476 12.7742 5.4037 11.1253L5.79066 10.7383"
        stroke="#C2CBDE"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M14.2097 9.26153L14.5966 8.87458C16.2456 7.22563 16.2456 4.55216 14.5966 2.90321C12.9477 1.25427 10.2742 1.25427 8.62526 2.90321L6.23671 5.29176C4.58776 6.94071 4.58776 9.61418 6.23671 11.2631C7.88566 12.9121 10.5591 12.9121 12.2081 11.2631L12.3805 11.0907"
        stroke="#C2CBDE"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const MemoShare = React.memo(Share);
export default MemoShare;
