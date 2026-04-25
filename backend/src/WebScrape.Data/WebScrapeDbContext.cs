using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using WebScrape.Data.Entities;
using WebScrape.Data.Enums;

namespace WebScrape.Data;

public class WebScrapeDbContext : IdentityDbContext<User, IdentityRole<Guid>, Guid>
{
    public WebScrapeDbContext(DbContextOptions<WebScrapeDbContext> options) : base(options)
    {
    }

    public DbSet<ApiKey> ApiKeys => Set<ApiKey>();
    public DbSet<ScraperConfigEntity> ScraperConfigs => Set<ScraperConfigEntity>();
    public DbSet<TaskEntity> Tasks => Set<TaskEntity>();
    public DbSet<TaskBlock> TaskBlocks => Set<TaskBlock>();
    public DbSet<WorkerConnection> WorkerConnections => Set<WorkerConnection>();
    public DbSet<RunItem> RunItems => Set<RunItem>();
    public DbSet<RunBatch> RunBatches => Set<RunBatch>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        var jsonConverter = new ValueConverter<JsonDocument, string>(
            v => v.RootElement.GetRawText(),
            v => JsonDocument.Parse(v, new JsonDocumentOptions()));

        var nullableJsonConverter = new ValueConverter<JsonDocument?, string?>(
            v => v == null ? null : v.RootElement.GetRawText(),
            v => v == null ? null : JsonDocument.Parse(v, new JsonDocumentOptions()));

        builder.Entity<ApiKey>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
            e.Property(x => x.Hash).IsRequired();
            e.Property(x => x.Prefix).IsRequired();
            e.HasIndex(x => x.Prefix);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<ScraperConfigEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
            e.Property(x => x.Domain).IsRequired();
            e.Property(x => x.ConfigJson).HasColumnType("jsonb").HasConversion(jsonConverter).IsRequired();
            e.Property(x => x.SchemaVersion).HasDefaultValue(3);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TaskEntity>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasMany(x => x.Blocks).WithOne(x => x.Task!).HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<TaskBlock>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.BlockType).HasConversion<string>().IsRequired();
            e.Property(x => x.OrderIndex).IsRequired();
            e.Property(x => x.ConfigJsonb).HasColumnType("jsonb").HasConversion(jsonConverter).IsRequired();
            e.HasOne(x => x.ParentBlock).WithMany(x => x.Children).HasForeignKey(x => x.ParentBlockId).OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => new { x.TaskId, x.ParentBlockId, x.OrderIndex });
        });

        builder.Entity<WorkerConnection>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).IsRequired();
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.ApiKey).WithMany().HasForeignKey(x => x.ApiKeyId).OnDelete(DeleteBehavior.Restrict);
            e.HasIndex(x => x.CurrentConnection);
        });

        builder.Entity<RunBatch>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.PopulateSnapshot).HasColumnType("jsonb").HasConversion(jsonConverter).IsRequired();
            e.HasOne(x => x.Task).WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.User).WithMany().HasForeignKey(x => x.UserId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Worker).WithMany().HasForeignKey(x => x.WorkerId).OnDelete(DeleteBehavior.Restrict);
        });

        builder.Entity<RunItem>(e =>
        {
            e.HasKey(x => x.Id);
            e.Property(x => x.Status).HasConversion<string>().IsRequired();
            e.Property(x => x.ResultJsonb).HasColumnType("jsonb").HasConversion(nullableJsonConverter);
            e.Property(x => x.IterationAssignments).HasColumnType("jsonb").HasConversion(nullableJsonConverter);
            e.HasOne(x => x.Task).WithMany().HasForeignKey(x => x.TaskId).OnDelete(DeleteBehavior.Cascade);
            e.HasOne(x => x.Worker).WithMany().HasForeignKey(x => x.WorkerId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne(x => x.Batch).WithMany().HasForeignKey(x => x.BatchId).OnDelete(DeleteBehavior.SetNull);
            e.HasIndex(x => new { x.TaskId, x.RequestedAt });
            e.HasIndex(x => x.Status);
            e.HasIndex(x => x.BatchId);
        });
    }
}
