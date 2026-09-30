import * as React from "react";
import { IconProps } from "./types";

function Settings(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 20 18" fill="none" {...props}>
      <path d="M12.917 9a2.917 2.917 0 11-5.834 0 2.917 2.917 0 015.834 0z" stroke="#DDECFF" strokeWidth={1.5} />
      <path
        d="M17.325 6.627c.672 1.158 1.008 1.737 1.008 2.373 0 .636-.336 1.215-1.008 2.373l-1.603 2.764c-.669 1.153-1.003 1.73-1.554 2.046-.55.317-1.218.317-2.554.317H8.386c-1.336 0-2.004 0-2.554-.317-.55-.316-.885-.893-1.554-2.046l-1.604-2.764C2.003 10.215 1.667 9.636 1.667 9c0-.636.336-1.215 1.007-2.373l1.604-2.763c.669-1.154 1.003-1.73 1.554-2.047C6.382 1.5 7.05 1.5 8.386 1.5h3.228c1.336 0 2.004 0 2.554.317.55.316.885.893 1.554 2.047l1.603 2.763z"
        stroke="#DDECFF"
        strokeWidth={1.5}
      />
    </svg>
  );
}

const MemoSettings = React.memo(Settings);
export default MemoSettings;
