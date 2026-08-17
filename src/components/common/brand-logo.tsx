import Image from "next/image";

/**
 * VELOS Brand Logo — the Veles symbol (inverted A) on a copper/amber gradient tile.
 * Used in sidebar, login, portal, verify pages, and email headers.
 *
 * The symbol is derived from the Slavic god Veles:
 * https://en.wikipedia.org/wiki/Veles_(god)#/media/File:Symbol_of_Veles.svg
 */
export function BrandLogo({
  size = 36,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/logo.svg"
      alt="VELOS"
      width={size}
      height={size}
      priority
      className={className}
      style={{ width: size, height: size }}
    />
  );
}

/**
 * Compact brand lockup — logo + wordmark, for headers and footers.
 */
export function BrandLockup({
  size = 36,
  showText = true,
  className,
}: {
  size?: number;
  showText?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <BrandLogo size={size} />
      {showText && (
        <div className="leading-tight">
          <p className="font-semibold text-[15px] tracking-tight text-sidebar-foreground">
            VELOS
          </p>
        </div>
      )}
    </div>
  );
}

// Local cn to avoid circular import if utils is heavy
function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(" ");
}
