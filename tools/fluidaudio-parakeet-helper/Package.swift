// swift-tools-version: 6.0
import PackageDescription

// This is intentionally an exact release rather than a range.  The helper is
// compiled into LocalScribe's macOS resources during a release build; a new
// FluidAudio version is a conscious supply-chain update, not an implicit build
// time resolution.
let package = Package(
    name: "LocalScribeFluidAudioHelper",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            exact: "0.15.5"
        )
    ],
    targets: [
        .executableTarget(
            name: "localscribe-fluidaudio-parakeet",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio")
            ]
        )
    ]
)
