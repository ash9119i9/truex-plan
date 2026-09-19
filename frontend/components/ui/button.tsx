import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
const variants = cva("button", {
  variants: {
    variant: {
      default: "button-primary",
      outline: "button-outline",
      ghost: "button-ghost",
    },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  className,
  variant,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof variants>) {
  return <button className={cn(variants({ variant }), className)} {...props} />;
}
