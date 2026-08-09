import type {
  CSSProperties,
  InputHTMLAttributes,
} from "react";
import "./ScalarBar.css";

type ScalarBarProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "min" | "max" | "step" | "onChange" | "className" | "style"
> & {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  className?: string;
  style?: CSSProperties;
};

const percent = (value: number, min: number, max: number) => {
  if (max <= min) return 0;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
};

export function ScalarBar({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onChange,
  className = "",
  style,
  ...props
}: ScalarBarProps) {
  const progress = percent(value, min, max);
  const trackStyle = {
    ...style,
    "--scalar-progress": `${progress}%`,
  } as CSSProperties;

  return (
    <span className={`scalar-bar ${className}`.trim()} style={trackStyle}>
      <input
        {...props}
        className="scalar-bar__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
      <span className="scalar-bar__track" aria-hidden="true">
        <span className="scalar-bar__fill" aria-hidden="true" />
      </span>
    </span>
  );
}
