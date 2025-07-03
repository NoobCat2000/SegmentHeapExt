const log = host.diagnostics.debugLog;
const logln = p => host.diagnostics.debugLog(p + '\n');
const hex = p => p.toString(16);
let exec = function(expr) {
    return host.namespace.Debugger.Utility.Control.ExecuteCommand(expr)
}

function curprocess() { return host.namespace.Debugger.State.DebuggerVariables.curprocess; }
function ptrsize() { return host.namespace.Debugger.State.PseudoRegisters.General.ptrsize; }
function IsX64() { return ptrsize() === 8; }
function IsKd() { return host.namespace.Debugger.State.DebuggerVariables.cursession.Attributes.Target.IsKernelTarget === true; }

function ReadQword(Address) {
    let Value = null
    try {
        Value = host.memory.readMemoryValues(
           Address, 1, 8
        )[0]
    } catch(e) {
        logln('[X] Failed to read address ' + hex(Address))
    }

    return Value
}

function ReadDword(Address) {
    let Value = null
    try {
        Value = host.memory.readMemoryValues(
           Address, 1, 4
        )[0]
    } catch(e) {
        logln('[X] Failed to read address ' + hex(Address))
    }

    return Value
}

function ReadWord(Address) {
    let Value = null
    try {
        Value = host.memory.readMemoryValues(
            Address, 1, 2
        )[0]
    } catch(e) {
        logln('[X] Failed to read address ' + hex(Address))
    }

    return Value
}

class HeapPageRangeDescriptor {
    constructor(object, heapPageSegmentAddr, index, unitSize) {
        this.Object = object
        this.PageRangeDescriptor = host.createTypedObject(heapPageSegmentAddr.add(index * 0x20), "nt", "_HEAP_PAGE_RANGE_DESCRIPTOR")
        this.SegmentBaseAddress = heapPageSegmentAddr.add(0x1000 * index)
        this.SegmentEndAddress = heapPageSegmentAddr.add(0x1000 * (index + unitSize))
        this.SegmentSize = this.SegmentEndAddress.subtract(this.SegmentBaseAddress)
    }

    get RangeFlags() {
        if (this.Object.RangeFlags == 11) {
            return 'LFH_SUBSEGMENT'
        }
        else if (this.Object.RangeFlags == 15) {
            return 'VS_SUBSEGMENT'
        }
        else if (this.Object.RangeFlags == 3) {
            return 'Large Pool Subsegment'
        }
        else {
            return 'Unknown Subsegment'
        }
    }

    toString() {
        return this.RangeFlags
    }
}

class HeapPageSegment {
    constructor(object) {
        this.Object = object
        this.NumberOfPageRangeDescs = object.DescArray.Count()
        this.PageRangeDescs = []
        for (let i = 2; i < 256; i++) {
            let rangeDesc = object.DescArray[i]
            if (rangeDesc.TreeSignature == 0xccddccdd) {
                this.PageRangeDescs.push(new HeapPageRangeDescriptor(rangeDesc, object.address, i, rangeDesc.UnitSize))
                i += rangeDesc.UnitSize - 1
            }
        }
    }
}

class HeapSegContext {
    constructor(object) {
        this.Object = object
        this.SegmentCount = object.SegmentCount
        this.SegmentHeap = object.Heap
        let pageSegmentList = host.namespace.Debugger.Utility.Collections.FromListEntry(object.SegmentListHead, "nt!_HEAP_PAGE_SEGMENT", "ListEntry")
        this.HeapPageSegments = []
        for (let pageSegment of pageSegmentList) {
            this.HeapPageSegments.push(new HeapPageSegment(pageSegment))
        }
    }
}

class LfhBlockState {
    constructor(address, BitState) {
        this.Address = address
        this.__BitState = BitState
    }

    get Busy() {
        if ((this.__BitState & 1) == 1) {
            return 'Busy'
        }
        else {
            return 'Free'
        }
    }
}

class HeapLfhSubsegment {
    constructor(object) {
        this.Object = object
        this.FreeHint = object.FreeHint
        this.SubsegmentAddress = object.address
        this.BlockCount = object.BlockCount
        
        let blockOffsets = object.BlockOffsets
        let encodedData = blockOffsets.BlockSize + (blockOffsets.FirstBlockOffset << 16)
        let RtlpHpHeapGlobals = host.getModuleSymbolAddress('nt', 'RtlpHpHeapGlobals')
        let decodedData = ReadDword(RtlpHpHeapGlobals.add(8)) ^ encodedData ^ (object.address.bitwiseAnd(0xffffffff) >>> 12)
        decodedData &= 0xffffffff
        this.BlockSize = decodedData & 0xffff
        this.FirstBlockOffset = host.Int64(decodedData >> 16)
        this.BlockList = []
        let TotalBit = this.BlockCount * 2
        for (let i = 0; i < TotalBit; i += 2) {
            let IndexOfChunk = Math.floor(i / 64)
            let remain = i % 64
            let ChunkValue = object.BlockBitmap[IndexOfChunk]
            let ByteValue = ChunkValue.bitwiseShiftRight(8 * Math.floor(remain / 8)).bitwiseAnd(0xff)
            let IndexOfBit = remain % 8
            let BitValue = ByteValue.bitwiseShiftRight(8 - (IndexOfBit + 2)).bitwiseAnd(3)
            let BlockAddress = this.SubsegmentAddress.add(this.FirstBlockOffset).add((i / 2) * this.BlockSize)
            this.BlockList.push(new LfhBlockState(BlockAddress, BitValue))
        }
    }

    get Location() {
        if (this.Object.Location == 0) {
            return 'AvailableSubsegmentList'
        }
        else if (this.Object.Location == 1) {
            return 'FullSubsegmentList'
        }
        else {
            return 'Unknown Location'
        }
    }
}

class HeapLfhBucket {
    constructor(object, lfhContext) {
        this.Object = object
        this.LfhContext = lfhContext.address
        let affinitySlots = object.AffinitySlots
        let activeSubsegment = affinitySlots.ActiveSubsegment.Target.address
        activeSubsegment = activeSubsegment.subtract(activeSubsegment.bitwiseAnd(0xfff))

        let state = affinitySlots.State
        let availableList = host.namespace.Debugger.Utility.Collections.FromListEntry(state.AvailableSubsegmentList, "nt!_HEAP_LFH_SUBSEGMENT", "ListEntry")
        let fullList = host.namespace.Debugger.Utility.Collections.FromListEntry(state.FullSubsegmentList, "nt!_HEAP_LFH_SUBSEGMENT", "ListEntry")
        this.AvailableList = []
        this.FullSubsegmentList = []
        for (let lfhSubsegment of availableList) {
            this.AvailableList.push(new HeapLfhSubsegment(lfhSubsegment))
        }

        for (let lfhSubsegment of fullList) {
            this.FullSubsegmentList.push(new HeapLfhSubsegment(lfhSubsegment))
        }
    }
}

class HeapLfhContext {
    constructor(object) {
        this.Object = object
        this.MaxBlockSize = object.Config.MaxBlockSize
        this.DisableRandomization = object.Config.DisableRandomization
        this.Buckets = []
        for (let bucket of object.Buckets) {
            if (bucket.address.bitwiseAnd(1) == 1) {
                continue
            }

            this.Buckets.push(new HeapLfhBucket(bucket, object))
        }
    }

    get EnableRandomization() {
        if (object.Config.DisableRandomization == 0) {
            return 'True'
        }
        else {
            return 'False'
        }
    }
}

class HeapVsChunkFreeHeader {
    constructor(object) {
        this.Object = object
        let RtlpHpHeapGlobals = host.getModuleSymbolAddress('nt', 'RtlpHpHeapGlobals')
        let VsChunkHeaderSize = host.createTypedObject(object.address, 'nt', '_HEAP_VS_CHUNK_HEADER_SIZE')
        let DecodedHeaderBits = object.address.bitwiseXor(ReadQword(RtlpHpHeapGlobals)).bitwiseXor(ReadQword(object.address))
        this.Address = object.address
        this.UnsafeSize = DecodedHeaderBits.bitwiseAnd(0xffffffff).bitwiseShiftRight(16).multiply(16)
        this.UnsafePrevSize = DecodedHeaderBits.bitwiseShiftRight(32).bitwiseAnd(0xffff).multiply(16)
        let Allocated = DecodedHeaderBits.bitwiseShiftRight(48).bitwiseAnd(0xff)
        if (Allocated != 0) {
            this.Allocated = true
        }
        else {
            this.Allocated = false
        }

        this.VsChunkHeaderSize = VsChunkHeaderSize
    }
}

function RedBlackTreeWalker(NodeArray, BalancedNode, FreeChunkTree) {
    let FreeChunkHdr = host.createTypedObject(BalancedNode.address.subtract(8), 'nt', '_HEAP_VS_CHUNK_FREE_HEADER')
    NodeArray.push(new HeapVsChunkFreeHeader(FreeChunkHdr))
    if (BalancedNode.Left.address.compareTo(0) != 0) {
        let Left = BalancedNode.Left
        if (FreeChunkTree.Encoded != 0) {
            Left = host.createTypedObject(Left.address.bitwiseXor(FreeChunkTree.address), 'nt', '_RTL_BALANCED_NODE')
        }

        RedBlackTreeWalker(NodeArray, Left, FreeChunkTree)
    }
    
    if (BalancedNode.Right.address.compareTo(0) != 0) {
        let Right = BalancedNode.Right
        if (FreeChunkTree.Encoded != 0) {
            Right = host.createTypedObject(Right.address.bitwiseXor(FreeChunkTree.address), 'nt', '_RTL_BALANCED_NODE')
        }

        RedBlackTreeWalker(NodeArray, Right, FreeChunkTree)
    }
}

class HeapVsContext {
    constructor(object) {
        this.Object = object
        this.Flags = object.Config.Flags
        this.NodeArray = []
        RedBlackTreeWalker(this.NodeArray, object.FreeChunkTree.Root, object.FreeChunkTree)
    }

    get LockType() {
        if (object.LockType == 0) {
            return 'HeapLockPaged'
        }
        else if (object.LockType == 1) {
            return 'HeapLockNonPaged'
        }
        else {
            return 'HeapLockTypeMax'
        }
    }

    get SegmentHeap() {
        return this.Object.BackendCtx
        // return `0x${hex(this.Object.BackendCtx)} [_SEGMENT_HEAP]`
    }
}

class SegmentHeap {
    constructor(address) {
        this.Object = host.createTypedObject(address, "nt", "_SEGMENT_HEAP")
    }

    get SegContexts() {
        return [new HeapSegContext(this.Object.SegContexts[0]), new HeapSegContext(this.Object.SegContexts[1])]
    }

    get Signature() {
        return this.Object.Signature
    }

    get LfhContext() {
        return `0x${hex(this.Object.LfhContext.address)} [_HEAP_LFH_CONTEXT]`
    }

    get VsContext() {
        return `0x${hex(this.Object.VsContext.address)} [_HEAP_VS_CONTEXT]`
    }
}

function DumpSegmentHeap(address) {
    if (!IsKd()) {
        logln('[X] This extension is only for kernel debugging')
        return
    }

    if (!IsX64()) {
        logln('[X] This extension is only for Windows 64 bit')
        return
    }

    let segmentHeap = new SegmentHeap(address)
    if (segmentHeap.Signature != 0xddeeddee) {
        logln('Invalid _SEGMENT_HEAP.Signature: ' + hex(segmentHeap.Signature) + ' (expected: 0xddeeddee)')
        return
    }

    return segmentHeap
}

function DumpLfhSugsegment(address) {
    if (!IsKd()) {
        logln('[X] This extension is only for kernel debugging')
        return
    }

    if (!IsX64()) {
        logln('[X] This extension is only for Windows 64 bit')
        return
    }

    let object = host.createTypedObject(address, "nt", "_HEAP_LFH_SUBSEGMENT")
    return new HeapLfhSubsegment(object)
}

function DumpLfgContext(address) {
    if (!IsKd()) {
        logln('[X] This extension is only for kernel debugging')
        return
    }

    if (!IsX64()) {
        logln('[X] This extension is only for Windows 64 bit')
        return
    }

    let object = host.createTypedObject(address, "nt", "_HEAP_LFH_CONTEXT")
    return new HeapLfhContext(object)
}

function DumpVsContext(address) {
    if (!IsKd()) {
        logln('[X] This extension is only for kernel debugging')
        return
    }

    if (!IsX64()) {
        logln('[X] This extension is only for Windows 64 bit')
        return
    }

    let object = host.createTypedObject(address, "nt", "_HEAP_VS_CONTEXT")
    return new HeapVsContext(object)
}

function initializeScript()
{
    return [new host.functionAlias(DumpSegmentHeap, "segheap"),
        new host.functionAlias(DumpLfhSugsegment, "lfhsub"),
        new host.functionAlias(DumpLfgContext, "lfhctx"),
        new host.functionAlias(DumpVsContext, "vsctx"),
            new host.apiVersionSupport(1, 7)]
}