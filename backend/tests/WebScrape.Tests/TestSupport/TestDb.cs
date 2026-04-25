using AutoMapper;
using Microsoft.EntityFrameworkCore;
using WebScrape.Data;
using WebScrape.Data.Mapping;

namespace WebScrape.Tests.TestSupport;

public static class TestDb
{
    public static WebScrapeDbContext CreateInMemory()
    {
        var options = new DbContextOptionsBuilder<WebScrapeDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new WebScrapeDbContext(options);
    }

    public static IMapper CreateMapper()
    {
        var cfg = new MapperConfiguration(c => c.AddProfile<AutoMapperProfile>());
        return cfg.CreateMapper();
    }
}
