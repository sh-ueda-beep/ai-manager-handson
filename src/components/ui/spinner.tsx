import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Spinner({ className, ...props }: React.SVGAttributes<SVGSVGElement>) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-gray-500', className)} {...props} />
}
