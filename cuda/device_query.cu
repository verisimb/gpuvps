#include <stdio.h>
#include <cuda_runtime.h>

int main() {
    int deviceCount;
    cudaGetDeviceCount(&deviceCount);
    if (deviceCount == 0) {
        printf("0,0\n");
        return 1;
    }

    cudaDeviceProp prop;
    cudaGetDeviceProperties(&prop, 0);
    // Return format: SM_Count,Max_Threads_Per_Block
    printf("%d,%d\n", prop.multiProcessorCount, prop.maxThreadsPerBlock);
    return 0;
}
