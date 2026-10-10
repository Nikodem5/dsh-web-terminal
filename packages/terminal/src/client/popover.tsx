// dsh-web-terminal — keeps a toolbar popover usable: it never grows past the page bottom (it scrolls instead),
// stays inside the viewport horizontally, and wheel scrolling inside it does not reach the page behind.

import { forwardRef, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'

const MARGIN = 16

/** Space from the popover's top to the page bottom, minus a margin; never below a small floor. */
export function popoverMaxHeight(top: number, viewportHeight: number): number {
  return Math.max(120, Math.floor(viewportHeight - top - MARGIN))
}

/** Sets max-height / overflow on the element at mount and on every window resize. */
export function usePopoverBounds(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const fit = () => {
      el.style.transform = ''
      el.style.maxHeight = `${popoverMaxHeight(el.getBoundingClientRect().top, window.innerHeight)}px`
      el.style.overflowY = 'auto'
      el.style.maxWidth = `${Math.max(160, window.innerWidth - 2 * 8)}px`
      const r = el.getBoundingClientRect()
      if (r.width === 0) return
      if (r.right > window.innerWidth - 8) el.style.transform = `translateX(${window.innerWidth - 8 - r.right}px)`
      else if (r.left < 8) el.style.transform = `translateX(${8 - r.left}px)`
    }
    const wheel = (e: Event) => e.stopPropagation()
    fit()
    window.addEventListener('resize', fit)
    el.addEventListener('wheel', wheel)
    return () => {
      window.removeEventListener('resize', fit)
      el.removeEventListener('wheel', wheel)
    }
  }, [ref])
}

type PopProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'ref'> & { 'data-right'?: string }

/** A `.wt-pop` popover that keeps itself inside the viewport (scrolls when taller than the space below it). */
export const Pop = forwardRef<HTMLDivElement | null, PopProps>(function Pop({ className, children, ...rest }, outer) {
  const ref = useRef<HTMLDivElement | null>(null)
  usePopoverBounds(ref)
  return (
    <div
      {...rest}
      className={className === undefined ? 'wt-pop' : `wt-pop ${className}`}
      ref={(el) => {
        ref.current = el
        if (typeof outer === 'function') outer(el)
        else if (outer !== null) outer.current = el
      }}
    >
      {children}
    </div>
  )
})
