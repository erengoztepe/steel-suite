import * as React from "react";
import { IconProps } from "./types";

function Edit(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path
        d="M9.38215 2.59046C9.87894 2.05222 10.1273 1.78309 10.3913 1.62611C11.0282 1.24734 11.8124 1.23556 12.4599 1.59504C12.7283 1.74403 12.9843 2.00558 13.4964 2.52867C14.0084 3.05176 14.2645 3.31331 14.4103 3.58745C14.7622 4.24891 14.7507 5.05002 14.3799 5.70063C14.2262 5.97027 13.9628 6.22401 13.4359 6.7315L7.16676 12.7697C6.16826 13.7314 5.66901 14.2123 5.04505 14.456C4.42109 14.6997 3.73514 14.6818 2.36325 14.6459L2.17659 14.641C1.75894 14.6301 1.55012 14.6246 1.42873 14.4869C1.30734 14.3491 1.32392 14.1364 1.35706 13.7109L1.37506 13.4799C1.46835 12.2825 1.51499 11.6838 1.74881 11.1456C1.98263 10.6075 2.38596 10.1705 3.19263 9.2965L9.38215 2.59046Z"
        stroke="white"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M8.66699 2.6665L13.3337 7.33317"
        stroke="white"
        strokeOpacity="0.8"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MemoEdit = React.memo(Edit);
export default MemoEdit;
