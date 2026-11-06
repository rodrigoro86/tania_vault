# Backend Rust (`tania`): login, usuários, vault; proxy para o Node legado.
# Multi-stage — o build precisa da toolchain completa, o runtime só do binário.
FROM rust:1.94-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
COPY migrations/ migrations/
RUN cargo build --release --locked

# distroless: sem shell, sem apt, só a libc + o binário estático-dinâmico.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /src/target/release/tania /tania
ENV PORT=3100
EXPOSE 3100
ENTRYPOINT ["/tania"]
