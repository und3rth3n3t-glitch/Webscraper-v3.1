# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src

COPY ["src/WebScrape.Server/WebScrape.Server.csproj", "src/WebScrape.Server/"]
COPY ["src/WebScrape.Services/WebScrape.Services.csproj", "src/WebScrape.Services/"]
COPY ["src/WebScrape.Data/WebScrape.Data.csproj", "src/WebScrape.Data/"]
RUN dotnet restore "src/WebScrape.Server/WebScrape.Server.csproj"

COPY src/ src/
RUN dotnet publish "src/WebScrape.Server/WebScrape.Server.csproj" \
    -c Release \
    -o /app/publish \
    /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:9.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "WebScrape.Server.dll"]
