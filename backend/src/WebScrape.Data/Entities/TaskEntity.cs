namespace WebScrape.Data.Entities;

public class TaskEntity
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public string Name { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
    public User? User { get; set; }
    public ICollection<TaskBlock> Blocks { get; set; } = new List<TaskBlock>();
}
