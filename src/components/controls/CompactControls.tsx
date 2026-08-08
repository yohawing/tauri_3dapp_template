import type {
  CSSProperties,
  InputHTMLAttributes,
  SelectHTMLAttributes,
} from "react";
import "./CompactControls.css";

type RangeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function RangeInput({ className = "", min = 0, max = 100, value, defaultValue, style, ...props }: RangeInputProps) {
  const minimum = Number(min);
  const maximum = Number(max);
  const current = Number(value ?? defaultValue ?? minimum);
  const progress = maximum > minimum
    ? Math.min(100, Math.max(0, ((current - minimum) / (maximum - minimum)) * 100))
    : 0;

  return (
    <input
      {...props}
      className={`ui-range ${className}`.trim()}
      type="range"
      min={min}
      max={max}
      value={value}
      defaultValue={defaultValue}
      style={{ ...style, "--ui-range-progress": `${progress}%` } as CSSProperties}
    />
  );
}

type CheckboxInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function CheckboxInput({ className = "", ...props }: CheckboxInputProps) {
  return <input {...props} className={`ui-checkbox ${className}`.trim()} type="checkbox" />;
}

export function CompactNumberInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input {...props} className={`ui-number-input ${className}`.trim()} type="number" />;
}

export function CompactSelect({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`ui-select ${className}`.trim()}>
      {children}
    </select>
  );
}
