import { type ValueTextProps, valueClasses } from "./presentation.js";

/** The DOM text leaf; masking has spoken text without assigning a false control/image role. */
export function ValueText(props: ValueTextProps) {
  return (
    <span className={valueClasses(props)}>
      {props.text === props.accessibleText ? (
        props.text
      ) : (
        <>
          <span aria-hidden="true">{props.text}</span>
          <span className="sr-only">{props.accessibleText}</span>
        </>
      )}
    </span>
  );
}
