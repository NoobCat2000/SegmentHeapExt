## Preface
I have written a small WinDbg Extension to assist in parsing _SEGMENT_HEAP in the Windows Kernel. I hope it can help everyone better understand the mechanism of Segment Heap in the Windows Kernel.

## Supported commands
!segheap _SEGMENT_HEAP address
!lfhsub _HEAP_LFH_SUBSEGMENT address
!lfhctx _HEAP_LFH_CONTEXT address
!vsctx _HEAP_VS_CONTEXT address

The usage is !\<command\> \<address\> where \<address\> is the address of the corresponding structure.
A minor issue is how to find the address of _SEGMENT_HEAP. You can refer to the __ExAllocateHeapPool__ function and look for the code segment below.
![Batch Build](media/0.png)

Set breakpoint to each line and get _SEGMENT_HEAP address. After finding the address of _SEGMENT_HEAP, you can also obtain the addresses of _HEAP_LFH_CONTEXT and _HEAP_VS_CONTEXT.

## Help
This document by Mark Yason can assist you.
[Segment Heap Internals](https://www.blackhat.com/docs/us-16/materials/us-16-Yason-Windows-10-Segment-Heap-Internals-wp.pdf)